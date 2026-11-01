import { Router } from 'express';
import { chatWithAssistant } from '../controllers/assistant.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.post('/chat', chatWithAssistant);

export default router;
