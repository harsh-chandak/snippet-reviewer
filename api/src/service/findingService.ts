import { findingDao } from '../model/dao/FindingDao';
import { FindingStatus } from '../model/constants';
import { HttpError } from '../utils/httpError';

class FindingService {
  async setStatus(id: number, status: FindingStatus) {
    const updated = await findingDao.setStatus(id, status);
    if (!updated) throw new HttpError(404, 'Finding not found');
    return findingDao.findById(id);
  }
}

export const findingService = new FindingService();
