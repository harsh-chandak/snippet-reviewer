import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import db from '../../db/postgres';
import { LANGUAGES, Language, SNIPPET_REVIEW_STATUSES, SnippetReviewStatus } from '../constants';

// `declare` (not `public x!:`) so TypeScript class fields don't hide Sequelize's getters.
class Snippet extends Model<InferAttributes<Snippet>, InferCreationAttributes<Snippet>> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare language: Language;
  declare code: string;
  // Copied from the latest review, so the dashboard can filter on it without a join.
  declare reviewStatus: CreationOptional<SnippetReviewStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Snippet.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    title: { type: DataTypes.STRING(200), allowNull: false },
    language: { type: DataTypes.STRING(30), allowNull: false, validate: { isIn: [LANGUAGES as unknown as string[]] } },
    code: { type: DataTypes.TEXT, allowNull: false },
    reviewStatus: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'not_reviewed',
      validate: { isIn: [SNIPPET_REVIEW_STATUSES as unknown as string[]] },
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize: db,
    tableName: 'snippets',
    indexes: [{ fields: ['language'] }, { fields: ['reviewStatus'] }],
  },
);

export default Snippet;
