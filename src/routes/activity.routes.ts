import { Router } from 'express';
import { getActivityEvent, getActivitySummary, listActivityEvents } from '../controllers/activity.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();
router.use(requireAuth);
router.get('/', listActivityEvents);
router.get('/summary', getActivitySummary);
router.get('/:id', getActivityEvent);

export default router;
