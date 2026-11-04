import type { Migration } from '../db/migrator';

// 009 allows reviews.costSource = 'price-table' (the decision 'cost from list prices'): the API
// provider now prices tokens at the model's list price when no LLM_PRICE_* override is set.
// Values written out, so the migration keeps meaning what it meant when it ran.
const BEFORE = ['cli', 'price-config'];
const AFTER = ['cli', 'price-config', 'price-table'];

const NAME = 'reviews_cost_source_check';

async function replaceCheck(queryInterface: Parameters<Migration>[0]['context'], values: string[]) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeConstraint('reviews', NAME, { transaction });
    await queryInterface.addConstraint('reviews', {
      type: 'check',
      name: NAME,
      fields: ['costSource'],
      where: { costSource: values },
      transaction,
    });
  });
}

export const up: Migration = async ({ context: queryInterface }) => {
  await replaceCheck(queryInterface, AFTER);
};

// Going back, a cost priced from the list can't keep a source the old CHECK refuses. The cost is
// cleared with it, rather than labelled as if it came from settings.
export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query(
    `UPDATE reviews SET "costSource" = NULL, "costUsd" = NULL WHERE "costSource" = 'price-table'`,
  );
  await replaceCheck(queryInterface, BEFORE);
};
