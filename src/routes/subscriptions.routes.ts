import { Router } from 'express';
import {
  getMySubscription,
  getPayment,
  getSubscriptionPlans,
} from '../controllers/subscriptions.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/plans', getSubscriptionPlans);
router.get('/me', requireAuth, getMySubscription);
router.get('/payments/:id', requireAuth, getPayment);

export default router;
