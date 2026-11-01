import { Router } from 'express';
import {
  createEnglishStudySession,
  deleteEnglishStudySession,
  getEnglishStudyGoal,
  getEnglishStudySummary,
  listEnglishStudySessions,
  updateEnglishStudyGoal,
  updateEnglishStudySession,
} from '../controllers/english-study.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/summary', getEnglishStudySummary);
router.get('/goal', getEnglishStudyGoal);
router.put('/goal', updateEnglishStudyGoal);
router.get('/sessions', listEnglishStudySessions);
router.post('/sessions', createEnglishStudySession);
router.patch('/sessions/:id', updateEnglishStudySession);
router.delete('/sessions/:id', deleteEnglishStudySession);

export default router;
