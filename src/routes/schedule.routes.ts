import { Router } from 'express';
import {
  createScheduleEvent,
  deleteScheduleEvent,
  listScheduleAlerts,
  listScheduleEvents,
  updateScheduleEvent,
} from '../controllers/schedule.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();
router.use(requireAuth);

router.get('/alerts', listScheduleAlerts);
router.get('/', listScheduleEvents);
router.post('/', createScheduleEvent);
router.patch('/:id', updateScheduleEvent);
router.delete('/:id', deleteScheduleEvent);

export default router;
