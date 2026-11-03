import { CreationOptional, DataTypes, ForeignKey, InferAttributes, InferCreationAttributes, Model, NonAttribute } from 'sequelize';
import db from '../../db/postgres';
import { ACTIVE_REVIEW_STATUSES, REVIEW_STATUSES, ReviewStatus } from '../constants';
import type Finding from './Finding';
import type Snippet from './Snippet';

// One run of the model over one snippet. A snippet can be reviewed again, so it keeps every run.
class Review extends Model<InferAttributes<Review>, InferCreationAttributes<Review>> {
  declare id: CreationOptional<number>;
  declare snippetId: ForeignKey<Snippet['id']>;
  declare status: CreationOptional<ReviewStatus>;
  declare error: CreationOptional<string | null>;
  declare provider: string;
  // How many of the model's findings failed our checks and were dropped.
  declare rejectedCount: CreationOptional<number>;
  declare startedAt: CreationOptional<Date | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare findings?: NonAttribute<Finding[]>;
}

Review.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'pending',
      validate: { isIn: [REVIEW_STATUSES as unknown as string[]] },
    },
    error: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
    provider: { type: DataTypes.STRING(50), allowNull: false },
    rejectedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    startedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    completedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize: db,
    tableName: 'reviews',
    indexes: [
      { fields: ['snippetId', 'createdAt'] },
      // At most one pending or running review per snippet. The database enforces it, so two
      // clicks on "Review" at the same moment can't both start one; the second insert fails.
      {
        name: 'one_active_review_per_snippet',
        unique: true,
        fields: ['snippetId'],
        where: { status: ACTIVE_REVIEW_STATUSES },
      },
    ],
  },
);

export default Review;
