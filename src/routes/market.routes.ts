import { Router } from 'express';
import { getMarketAsset, getMarketMacro, listOpportunities } from '../controllers/market.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/opportunities', listOpportunities);
router.get('/macro', getMarketMacro);
router.get('/asset/:ticker', getMarketAsset);

export default router;
