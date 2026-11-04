import db from '../db/postgres';
import { findingDao } from '../model/dao/FindingDao';
import { FindingStatus } from '../model/constants';
import { HttpError } from '../utils/httpError';
import { event, reviewEventService } from './reviewEventService';

class FindingService {
  // The user's label on a finding. A change (accepted, dismissed, or reopened) is logged as
  // finding.resolved in the same transaction; setting the status it already has logs nothing.
  async setStatus(id: number, status: FindingStatus) {
    await db.transaction(async (transaction) => {
      const current = await findingDao.findByIdForUpdate(id, transaction);
      if (!current) throw new HttpError(404, 'Finding not found');
      if (current.status === status) return;
      await findingDao.setStatus(id, status, transaction);
      await reviewEventService.append(
        current.reviewId,
        [event('finding.resolved', { findingId: id, reviewId: current.reviewId, from: current.status, to: status })],
        transaction,
      );
    });
    return findingDao.findById(id);
  }
}

export const findingService = new FindingService();
