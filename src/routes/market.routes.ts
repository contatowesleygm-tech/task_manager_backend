import { Router } from 'express';
import { compareMarketFiis, getMarketAsset, getMarketMacro, listOpportunities, runMarketBacktest } from '../controllers/market.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/opportunities', listOpportunities);
router.get('/fiis/compare', compareMarketFiis);
router.get('/backtest', runMarketBacktest);
router.get('/macro', getMarketMacro);
router.get('/asset/:ticker', getMarketAsset);

export default router;
