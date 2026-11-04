import type { QueryInterface } from 'sequelize';
import type { Migration } from '../db/migrator';

// 006 redefines two of 005's analytics views (decisions 'token counts out of range' and 'rejection
// reason grouping'). No table changes. Down puts back 005's definitions, written out below, so this
// migration keeps meaning what it meant when it ran even if 005 is edited later.

// Token sums as bigint: each column is int4, but their sum can pass 2^31 and would error the whole view.
const V_REVIEW_COSTS = `
CREATE VIEW v_review_costs AS
SELECT r.id AS "reviewId",
       s.language,
       r.context,
       r.model,
       r."promptVersion",
       r."inputTokens"::bigint + COALESCE(r."cacheReadTokens", 0)::bigint + COALESCE(r."cacheWriteTokens", 0)::bigint
         AS "totalInputTokens",
       r."outputTokens",
       r."cacheReadTokens",
       r."costUsd",
       (r."phaseTimings" ->> 'static')::int AS "staticMs",
       (r."phaseTimings" ->> 'model')::int AS "modelMs",
       (r."phaseTimings" ->> 'checking')::int AS "checkingMs"
  FROM reviews r
  JOIN snippets s ON s.id = r."snippetId"`;

// Why the model's suggestions were thrown away, most common first. A reason is grouped with its
// numbers replaced by N ('line N is past the end (N lines)'), so one reason is one row. Where a
// review's log was truncated and holds fewer rejections than reviews."rejectedCount", that review's
// rejections are counted from rejectedCount, spread over the reasons it did log in proportion; if it
// logged none, they count under 'not logged (event log truncated)'.
const V_MODEL_REJECTIONS = `
CREATE VIEW v_model_rejections AS
WITH logged AS (
  SELECT e."reviewId", regexp_replace(e.payload ->> 'reason', '[0-9]+', 'N', 'g') AS reason, count(*) AS n
    FROM review_events e
   WHERE e.type = 'model.finding_rejected'
   GROUP BY 1, 2
), per_review AS (
  SELECT "reviewId", sum(n) AS logged FROM logged GROUP BY 1
), truncated AS (
  SELECT r.id AS "reviewId", r."rejectedCount", COALESCE(p.logged, 0) AS logged
    FROM reviews r
    LEFT JOIN per_review p ON p."reviewId" = r.id
   WHERE r."rejectedCount" > COALESCE(p.logged, 0)
     AND EXISTS (SELECT 1 FROM review_events t WHERE t."reviewId" = r.id AND t.type = 'events.truncated')
), counted AS (
  SELECT l.reason,
         CASE WHEN t."reviewId" IS NULL THEN l.n::numeric ELSE l.n::numeric * t."rejectedCount" / t.logged END AS n
    FROM logged l
    LEFT JOIN truncated t ON t."reviewId" = l."reviewId"
  UNION ALL
  SELECT 'not logged (event log truncated)', t."rejectedCount"::numeric
    FROM truncated t
   WHERE t.logged = 0
)
SELECT reason, round(sum(n))::int AS count
  FROM counted
 GROUP BY reason
 ORDER BY count DESC, reason`;

// 005's definitions, as 005 created them.
const V_REVIEW_COSTS_005 = `
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

const V_MODEL_REJECTIONS_005 = `
CREATE VIEW v_model_rejections AS
SELECT e.payload ->> 'reason' AS reason,
       count(*)::int AS count
  FROM review_events e
 WHERE e.type = 'model.finding_rejected'
 GROUP BY e.payload ->> 'reason'
 ORDER BY count(*) DESC, e.payload ->> 'reason'`;

// A column's type changes, so each view is dropped and created again (CREATE OR REPLACE can't do that).
async function replaceViews(queryInterface: QueryInterface, sqls: string[]) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    for (const view of ['v_model_rejections', 'v_review_costs']) {
      await queryInterface.sequelize.query(`DROP VIEW IF EXISTS ${view}`, { transaction });
    }
    for (const sql of sqls) await queryInterface.sequelize.query(sql, { transaction });
  });
}

export const up: Migration = async ({ context: queryInterface }) => {
  await replaceViews(queryInterface, [V_REVIEW_COSTS, V_MODEL_REJECTIONS]);
};

export const down: Migration = async ({ context: queryInterface }) => {
  await replaceViews(queryInterface, [V_REVIEW_COSTS_005, V_MODEL_REJECTIONS_005]);
};
