import { DataTypes } from 'sequelize';
import type { Migration } from '../db/migrator';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('findings', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    reviewId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'reviews', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    lineStart: { type: DataTypes.INTEGER, allowNull: false },
    lineEnd: { type: DataTypes.INTEGER, allowNull: false },
    severity: { type: DataTypes.STRING(20), allowNull: false },
    category: { type: DataTypes.STRING(20), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    suggestedFix: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addConstraint('findings', {
    type: 'check',
    name: 'findings_status_check',
    fields: ['status'],
    where: { status: ['open', 'accepted', 'dismissed'] },
  });
  await queryInterface.sequelize.query(`
    ALTER TABLE findings
      ADD CONSTRAINT findings_lines_check CHECK ("lineStart" >= 1 AND "lineEnd" >= "lineStart")
  `);

  await queryInterface.addIndex('findings', ['reviewId'], { name: 'findings_review_id' });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('findings');
};
