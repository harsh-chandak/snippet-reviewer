import { CreationOptional, DataTypes, ForeignKey, InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import db from '../../db/postgres';
import { REVIEW_EVENT_TYPES, ReviewEventType } from '../constants';
import type Review from './Review';

// One thing that happened during a review (a rule fired, the model was called, a fix was checked)
// or after it (the user accepted a finding). Rows are only ever inserted: the page and the
// analytics views read the same raw facts, in order.
class ReviewEvent extends Model<InferAttributes<ReviewEvent>, InferCreationAttributes<ReviewEvent>> {
  declare id: CreationOptional<number>;
  declare reviewId: ForeignKey<Review['id']>;
  declare type: ReviewEventType;
  declare payload: CreationOptional<Record<string, unknown>>;
  declare createdAt: CreationOptional<Date>;
}

ReviewEvent.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    type: {
      type: DataTypes.STRING(40),
      allowNull: false,
      validate: { isIn: [REVIEW_EVENT_TYPES as unknown as string[]] },
    },
    payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdAt: { type: DataTypes.DATE, allowNull: false },
  },
  {
    sequelize: db,
    tableName: 'review_events',
    updatedAt: false,
    indexes: [{ fields: ['reviewId', 'id'] }],
  },
);

export default ReviewEvent;
