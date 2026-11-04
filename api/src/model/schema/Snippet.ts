import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import db from '../../db/postgres';
import { CODE_CONTEXTS, CodeContext, LANGUAGES, Language, SNIPPET_REVIEW_STATUSES, SnippetReviewStatus } from '../constants';

// `declare` (not `public x!:`) so TypeScript class fields don't hide Sequelize's getters.
class Snippet extends Model<InferAttributes<Snippet>, InferCreationAttributes<Snippet>> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare language: Language;
  declare code: string;
  // Set by the user to correct the detection; null means detect it from the code.
  declare context: CreationOptional<CodeContext | null>;
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
    context: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: null,
      validate: { isIn: [CODE_CONTEXTS as unknown as string[]] },
    },
    reviewStatus: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'not_reviewed',
      validate: { isIn: [SNIPPET_REVIEW_STATUSES as unknown as string[]] },
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  {
    sequelize: db,
    tableName: 'snippets',
    indexes: [{ fields: ['language'] }, { fields: ['reviewStatus'] }],
  },
);

export default Snippet;
