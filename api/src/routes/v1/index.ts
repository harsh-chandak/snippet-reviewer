import express from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { healthController } from '../../controllers/v1/healthController';

export const v1Route = express.Router();

v1Route.get('/health', asyncHandler((req, res) => healthController.check(req, res)));
