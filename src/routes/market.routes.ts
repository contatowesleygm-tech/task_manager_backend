import { Router } from 'express';
import {
  analyzePortfolioFiis, compareMarketFiis, getFixedIncomeRates, getMarketAsset, getMarketMacro, listOpportunities,
  runMarketBacktest, simulatePortfolioSwitch,
} from '../controllers/market.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/opportunities', listOpportunities);
router.get('/fixed-income/benchmarks', getFixedIncomeRates);
router.get('/portfolio/fii-analysis', analyzePortfolioFiis);
router.get('/portfolio/switch-simulation', simulatePortfolioSwitch);
router.get('/fiis/compare', compareMarketFiis);
router.get('/backtest', runMarketBacktest);
router.get('/macro', getMarketMacro);
router.get('/asset/:ticker', getMarketAsset);

export default router;
