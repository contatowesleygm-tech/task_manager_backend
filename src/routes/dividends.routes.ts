import { Router } from 'express';
import {
  createDividendHolding,
  deleteDividendHolding,
  getDividendAssetTypes,
  getDividendHolding,
  getDividendPortfolio,
  refreshDividendPrices,
  getDividendProjection,
  listDividendHoldings,
  updateDividendHolding,
} from '../controllers/dividends.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/types', getDividendAssetTypes);
router.get('/projection', getDividendProjection);
router.get('/portfolio', getDividendPortfolio);
router.post('/refresh-prices', refreshDividendPrices);
router.get('/', listDividendHoldings);
router.post('/', createDividendHolding);
router.get('/:id', getDividendHolding);
router.patch('/:id', updateDividendHolding);
router.delete('/:id', deleteDividendHolding);

export default router;
