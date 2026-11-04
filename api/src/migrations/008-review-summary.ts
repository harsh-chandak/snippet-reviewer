import { DataTypes } from 'sequelize';
import type { Migration } from '../db/migrator';

// 008 adds reviews.summary (the decision 'review summary'): the model's optional 2-3 sentence
// overview of what the code does and its main risk, from the same structured answer as the
// findings. Control characters are stripped and it is cut to 400 characters before it is saved.
// Null when the model wrote none, wrote an invalid one, or never answered.

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.addColumn('reviews', 'summary', { type: DataTypes.TEXT, allowNull: true });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.removeColumn('reviews', 'summary');
};
