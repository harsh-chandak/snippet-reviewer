import { DataTypes } from 'sequelize';
import type { Migration } from '../db/migrator';

// 007 adds reviews.analysisError (the decision 'static analysis limits'): why the static step
// stopped (it ran out of time or memory, or the analyzer failed), in plain words, when it did.
// The review then went on model-only with no rule findings. Null when the static step finished.

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.addColumn('reviews', 'analysisError', { type: DataTypes.STRING(500), allowNull: true, defaultValue: null });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.removeColumn('reviews', 'analysisError');
};
