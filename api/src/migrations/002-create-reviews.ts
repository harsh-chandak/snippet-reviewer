import { DataTypes } from 'sequelize';
import type { Migration } from '../db/migrator';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('reviews', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    snippetId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'snippets', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    error: { type: DataTypes.TEXT, allowNull: true },
    provider: { type: DataTypes.STRING(50), allowNull: false },
    rejectedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addConstraint('reviews', {
    type: 'check',
    name: 'reviews_status_check',
    fields: ['status'],
    where: { status: ['pending', 'running', 'done', 'failed'] },
  });

  // "Latest review for this snippet."
  await queryInterface.addIndex('reviews', ['snippetId', 'createdAt'], { name: 'reviews_snippet_id_created_at' });

  // At most one pending or running review per snippet. Two clicks on "Review" at the same
  // moment both try to insert; the database lets one through and the other gets a unique violation (409).
  await queryInterface.sequelize.query(`
    CREATE UNIQUE INDEX one_active_review_per_snippet
      ON reviews ("snippetId")
      WHERE status IN ('pending', 'running')
  `);
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('reviews');
};
