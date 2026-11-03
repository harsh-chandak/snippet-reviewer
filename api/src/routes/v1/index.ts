import express from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import validate from '../../middleware/validate';
import { healthController } from '../../controllers/v1/healthController';
import { snippetController } from '../../controllers/v1/snippetController';
import { reviewController } from '../../controllers/v1/reviewController';
import { findingController } from '../../controllers/v1/findingController';
import { createSnippetSchema, idParamsSchema, listSnippetsSchema } from '../../validators/snippetValidation';
import { updateFindingSchema } from '../../validators/findingValidation';

export const v1Route = express.Router();

v1Route.get('/health', asyncHandler((req, res) => healthController.check(req, res)));
v1Route.get('/languages', asyncHandler((req, res) => snippetController.languages(req, res)));

v1Route.post('/snippets', validate(createSnippetSchema), asyncHandler((req, res) => snippetController.create(req, res)));
v1Route.get('/snippets', validate(listSnippetsSchema, 'query'), asyncHandler((req, res) => snippetController.list(req, res)));
v1Route.get('/snippets/:id', validate(idParamsSchema, 'params'), asyncHandler((req, res) => snippetController.get(req, res)));

v1Route.post(
  '/snippets/:id/reviews',
  validate(idParamsSchema, 'params'),
  asyncHandler((req, res) => reviewController.start(req, res)),
);
v1Route.get('/reviews/:id', validate(idParamsSchema, 'params'), asyncHandler((req, res) => reviewController.get(req, res)));

v1Route.patch(
  '/findings/:id',
  validate(idParamsSchema, 'params'),
  validate(updateFindingSchema),
  asyncHandler((req, res) => findingController.update(req, res)),
);
