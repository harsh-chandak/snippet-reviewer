import { DataTypes } from 'sequelize';
import type { Migration } from '../db/migrator';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('snippets', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    title: { type: DataTypes.STRING(200), allowNull: false },
    language: { type: DataTypes.STRING(30), allowNull: false },
    code: { type: DataTypes.TEXT, allowNull: false },
    reviewStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'not_reviewed' },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addConstraint('snippets', {
    type: 'check',
    name: 'snippets_review_status_check',
    fields: ['reviewStatus'],
    where: { reviewStatus: ['not_reviewed', 'in_progress', 'reviewed', 'failed'] },
  });

  // The dashboard filters on these two.
  await queryInterface.addIndex('snippets', ['language'], { name: 'snippets_language' });
  await queryInterface.addIndex('snippets', ['reviewStatus'], { name: 'snippets_review_status' });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('snippets');
};
