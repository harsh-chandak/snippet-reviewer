import { CreationOptional, DataTypes, ForeignKey, InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import db from '../../db/postgres';
import {
  CATEGORIES,
  FINDING_SOURCES,
  FINDING_STATUSES,
  FIX_CHECKS,
  FindingSource,
  FindingStatus,
  FixCheck,
  SEVERITIES,
} from '../constants';
import type { FixReplacement } from '../../service/analysis/types';
import type { FixCheckDetail } from '../../service/analysis/fixCheck';
import type Review from './Review';

class Finding extends Model<InferAttributes<Finding>, InferCreationAttributes<Finding>> {
  declare id: CreationOptional<number>;
  declare reviewId: ForeignKey<Review['id']>;
  declare lineStart: number;
  declare lineEnd: number;
  declare severity: (typeof SEVERITIES)[number];
  declare category: (typeof CATEGORIES)[number];
  declare description: string;
  declare suggestedFix: CreationOptional<string | null>;
  // Who raised it: a static rule (ruleId says which) or the model.
  declare source: CreationOptional<FindingSource>;
  declare ruleId: CreationOptional<string | null>;
  // A mechanical fix (replace lines lineStart..lineEnd), and what checking it found.
  declare fix: CreationOptional<FixReplacement | null>;
  declare fixCheck: CreationOptional<FixCheck>;
  declare fixCheckDetail: CreationOptional<FixCheckDetail | null>;
  // The user's decision on this finding. Survives reloads because it lives here.
  declare status: CreationOptional<FindingStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Finding.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    lineStart: { type: DataTypes.INTEGER, allowNull: false },
    lineEnd: { type: DataTypes.INTEGER, allowNull: false },
    severity: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [SEVERITIES as unknown as string[]] } },
    category: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [CATEGORIES as unknown as string[]] } },
    description: { type: DataTypes.TEXT, allowNull: false },
    suggestedFix: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
    source: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'model',
      validate: { isIn: [FINDING_SOURCES as unknown as string[]] },
    },
    ruleId: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
    fix: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
    fixCheck: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'not_checked',
      validate: { isIn: [FIX_CHECKS as unknown as string[]] },
    },
    fixCheckDetail: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'open',
      validate: { isIn: [FINDING_STATUSES as unknown as string[]] },
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  {
    sequelize: db,
    tableName: 'findings',
    indexes: [{ fields: ['reviewId'] }],
  },
);

export default Finding;
