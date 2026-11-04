import { DataTypes } from 'sequelize';
import type { Migration } from '../db/migrator';

// The event types as they are today, written out: a migration must keep meaning what it meant when
// it ran, even if REVIEW_EVENT_TYPES in model/constants.ts changes later.
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

// Rule findings per rule and what users did with them. dismiss_rate is dismissed over decided
// (accepted + dismissed), null until a finding of that rule has been decided.
const V_RULE_FEEDBACK = `
CREATE VIEW v_rule_feedback AS
SELECT f."ruleId",
       count(*)::int AS findings,
       count(*) FILTER (WHERE f.status = 'accepted')::int AS accepted,
       count(*) FILTER (WHERE f.status = 'dismissed')::int AS dismissed,
       count(*) FILTER (WHERE f.status = 'open')::int AS open,
       (count(*) FILTER (WHERE f.status = 'dismissed'))::double precision
         / NULLIF(count(*) FILTER (WHERE f.status IN ('accepted', 'dismissed')), 0) AS dismiss_rate
  FROM findings f
 WHERE f.source = 'rule'
 GROUP BY f."ruleId"`;

// What each review cost and how long each phase took. Total input counts every input token,
// including the ones written to and read from the prompt cache.
const V_REVIEW_COSTS = `
CREATE VIEW v_review_costs AS
SELECT r.id AS "reviewId",
       s.language,
       r.context,
       r.model,
       r."promptVersion",
       r."inputTokens" + COALESCE(r."cacheReadTokens", 0) + COALESCE(r."cacheWriteTokens", 0) AS "totalInputTokens",
       r."outputTokens",
       r."cacheReadTokens",
       r."costUsd",
       (r."phaseTimings" ->> 'static')::int AS "staticMs",
       (r."phaseTimings" ->> 'model')::int AS "modelMs",
       (r."phaseTimings" ->> 'checking')::int AS "checkingMs"
  FROM reviews r
  JOIN snippets s ON s.id = r."snippetId"`;

// Why the model's suggestions were thrown away, most common first.
const V_MODEL_REJECTIONS = `
CREATE VIEW v_model_rejections AS
SELECT e.payload ->> 'reason' AS reason,
       count(*)::int AS count
  FROM review_events e
 WHERE e.type = 'model.finding_rejected'
 GROUP BY e.payload ->> 'reason'
 ORDER BY count(*) DESC, e.payload ->> 'reason'`;

// The review event log (append-only: the app only ever inserts), prompt and rule-set version stamps
// on reviews, and three analytics views. One transaction, so a failure part way changes nothing.
export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'review_events',
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        reviewId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: 'reviews', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        type: { type: DataTypes.STRING(40), allowNull: false },
        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn('now') },
      },
      { transaction },
    );
    await queryInterface.addConstraint('review_events', {
      type: 'check',
      name: 'review_events_type_check',
      fields: ['type'],
      where: { type: EVENT_TYPES },
      transaction,
    });
    await queryInterface.addIndex('review_events', ['reviewId', 'id'], {
      name: 'review_events_review_id_id',
      transaction,
    });

    await queryInterface.addColumn('reviews', 'promptVersion', { type: DataTypes.STRING(40), allowNull: true }, { transaction });
    await queryInterface.addColumn('reviews', 'rulesetVersion', { type: DataTypes.STRING(40), allowNull: true }, { transaction });

    for (const sql of [V_RULE_FEEDBACK, V_REVIEW_COSTS, V_MODEL_REJECTIONS]) {
      await queryInterface.sequelize.query(sql, { transaction });
    }
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    for (const view of ['v_model_rejections', 'v_review_costs', 'v_rule_feedback']) {
      await queryInterface.sequelize.query(`DROP VIEW IF EXISTS ${view}`, { transaction });
    }
    await queryInterface.removeColumn('reviews', 'rulesetVersion', { transaction });
    await queryInterface.removeColumn('reviews', 'promptVersion', { transaction });
    await queryInterface.dropTable('review_events', { transaction });
  });
};
