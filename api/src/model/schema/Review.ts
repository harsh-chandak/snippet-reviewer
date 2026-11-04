import { CreationOptional, DataTypes, ForeignKey, InferAttributes, InferCreationAttributes, Model, NonAttribute } from 'sequelize';
import db from '../../db/postgres';
import {
  ACTIVE_REVIEW_STATUSES,
  CODE_CONTEXTS,
  CodeContext,
  REVIEW_PHASES,
  REVIEW_STATUSES,
  ReviewPhase,
  ReviewStatus,
} from '../constants';
import type Finding from './Finding';
import type Snippet from './Snippet';

// Milliseconds spent in each phase that has run.
export interface PhaseTimings {
  static?: number;
  model?: number;
  checking?: number;
}

export const COST_SOURCES = ['cli', 'price-config'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

// One run of the model over one snippet. A snippet can be reviewed again, so it keeps every run.
class Review extends Model<InferAttributes<Review>, InferCreationAttributes<Review>> {
  declare id: CreationOptional<number>;
  declare snippetId: ForeignKey<Snippet['id']>;
  declare status: CreationOptional<ReviewStatus>;
  declare error: CreationOptional<string | null>;
  declare provider: string;
  // How many of the model's findings failed our checks and were dropped.
  declare rejectedCount: CreationOptional<number>;
  // Where the run is: queued -> static -> model -> checking -> done, or failed.
  declare phase: CreationOptional<ReviewPhase>;
  declare phaseTimings: CreationOptional<PhaseTimings>;
  // The context the review used (the user's choice, else the detected one) and why.
  declare context: CreationOptional<CodeContext | null>;
  declare contextSignals: CreationOptional<string[]>;
  // false: no static rules for this language, the review is model-only. null until the static phase ends.
  declare staticSupported: CreationOptional<boolean | null>;
  // Model findings dropped because a rule had already reported them.
  declare duplicateCount: CreationOptional<number>;
  // What the model call used. Null when the provider reported nothing (or the model never ran).
  declare model: CreationOptional<string | null>;
  declare inputTokens: CreationOptional<number | null>;
  declare outputTokens: CreationOptional<number | null>;
  declare cacheReadTokens: CreationOptional<number | null>;
  declare cacheWriteTokens: CreationOptional<number | null>;
  declare costUsd: CreationOptional<number | null>;
  declare costSource: CreationOptional<CostSource | null>;
  // Which prompt and which rule set produced this review (see service/versions.ts), so a change in
  // dismiss rate can be tied to the change that caused it.
  declare promptVersion: CreationOptional<string | null>;
  declare rulesetVersion: CreationOptional<string | null>;
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
    phase: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'queued',
      validate: { isIn: [REVIEW_PHASES as unknown as string[]] },
    },
    phaseTimings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    context: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: null,
      validate: { isIn: [CODE_CONTEXTS as unknown as string[]] },
    },
    contextSignals: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    staticSupported: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
    duplicateCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    model: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
    inputTokens: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    outputTokens: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    cacheReadTokens: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    cacheWriteTokens: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    costUsd: { type: DataTypes.DOUBLE, allowNull: true, defaultValue: null },
    costSource: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: null,
      validate: { isIn: [COST_SOURCES as unknown as string[]] },
    },
    promptVersion: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
    rulesetVersion: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
    startedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    completedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
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
