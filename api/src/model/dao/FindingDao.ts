import { Transaction } from 'sequelize';
import { Finding } from '../schema';
import { FindingStatus, FixCheck } from '../constants';
import { LlmFinding } from '../../service/llm/reviewSchema';
import { RuleFinding } from '../../service/analysis/types';
import { FixCheckDetail } from '../../service/analysis/fixCheck';

// The result of checking one finding's fix; omitted (or not_checked) when there is no fix.
export interface CheckedFix {
  fixCheck: FixCheck;
  fixCheckDetail: FixCheckDetail | null;
}

const NOT_CHECKED: CheckedFix = { fixCheck: 'not_checked', fixCheckDetail: null };

class FindingDao {
  // Saved when the static phase ends, before the model runs, so the page can show them at once.
  async createRuleFindings(reviewId: number, findings: RuleFinding[], transaction?: Transaction) {
    return Finding.bulkCreate(
      findings.map((f) => ({
        reviewId,
        source: 'rule' as const,
        ruleId: f.ruleId,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        severity: f.severity,
        category: f.category,
        description: f.description,
        suggestedFix: f.suggestedFix || null,
        fix: f.fix ?? null,
      })),
      { transaction },
    );
  }

  // `checks[i]` is the fix check for `findings[i]`.
  async createModelFindings(
    reviewId: number,
    findings: LlmFinding[],
    checks: (CheckedFix | undefined)[] = [],
    transaction?: Transaction,
  ) {
    return Finding.bulkCreate(
      findings.map((f, i) => ({
        reviewId,
        source: 'model' as const,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        severity: f.severity,
        category: f.category,
        description: f.description,
        suggestedFix: f.suggestedFix || null,
        fix: f.fix ?? null,
        ...(checks[i] ?? NOT_CHECKED),
      })),
      { transaction },
    );
  }

  async setFixCheck(id: number, check: CheckedFix, transaction?: Transaction) {
    await Finding.update(check, { where: { id }, transaction });
  }

  async findById(id: number) {
    return Finding.findByPk(id);
  }

  async setStatus(id: number, status: FindingStatus) {
    const [count] = await Finding.update({ status }, { where: { id } });
    return count > 0;
  }
}

export const findingDao = new FindingDao();
