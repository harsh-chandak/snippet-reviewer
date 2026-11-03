import Joi from 'joi';
import { FINDING_STATUSES } from '../model/constants';

export const updateFindingSchema = Joi.object({
  status: Joi.string().valid(...FINDING_STATUSES).required(),
});
