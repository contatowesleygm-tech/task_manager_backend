import { Router } from 'express';
import {
  addGoalStep, createGoal, deleteGoal, deleteGoalStep, getGoal, listGoals, updateGoal, updateGoalStep,
} from '../controllers/goals.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();
router.use(requireAuth);

router.get('/', listGoals);
router.get('/:id', getGoal);
router.post('/', createGoal);
router.patch('/:id', updateGoal);
router.delete('/:id', deleteGoal);
router.post('/:id/steps', addGoalStep);
router.patch('/:id/steps/:stepId', updateGoalStep);
router.delete('/:id/steps/:stepId', deleteGoalStep);

export default router;
