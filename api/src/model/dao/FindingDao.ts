import { Transaction } from 'sequelize';
import { Finding } from '../schema';
import { FindingStatus } from '../constants';
import { LlmFinding } from '../../service/llm/reviewSchema';

class FindingDao {
  async createForReview(reviewId: number, findings: LlmFinding[], transaction?: Transaction) {
    return Finding.bulkCreate(
      findings.map((f) => ({
        reviewId,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        severity: f.severity,
        category: f.category,
        description: f.description,
        suggestedFix: f.suggestedFix || null,
      })),
      { transaction },
    );
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
