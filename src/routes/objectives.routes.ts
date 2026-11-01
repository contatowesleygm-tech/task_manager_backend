import { Router } from 'express';
import {
  createObjective,
  createObjectiveStep,
  deleteObjective,
  deleteObjectiveStep,
  getObjective,
  listObjectives,
  updateObjective,
  updateObjectiveStep,
} from '../controllers/objectives.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();
router.use(requireAuth);

router.get('/', listObjectives);
router.post('/', createObjective);
router.get('/:id', getObjective);
router.patch('/:id', updateObjective);
router.delete('/:id', deleteObjective);
router.post('/:id/steps', createObjectiveStep);
router.patch('/:id/steps/:stepId', updateObjectiveStep);
router.delete('/:id/steps/:stepId', deleteObjectiveStep);

export default router;
