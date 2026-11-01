import { Router } from 'express';
import {
  createFinancialAccount,
  createFinancialAsset,
  createFinancialLiability,
  deleteFinancialAccount,
  deleteFinancialAsset,
  deleteFinancialLiability,
  getFinanceSummary,
  listFinancialAccounts,
  listFinancialAssets,
  listFinancialLiabilities,
  updateFinancialAccount,
  updateFinancialAsset,
  updateFinancialLiability,
} from '../controllers/finances.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/summary', getFinanceSummary);
router.get('/accounts', listFinancialAccounts);
router.post('/accounts', createFinancialAccount);
router.patch('/accounts/:id', updateFinancialAccount);
router.delete('/accounts/:id', deleteFinancialAccount);
router.get('/assets', listFinancialAssets);
router.post('/assets', createFinancialAsset);
router.patch('/assets/:id', updateFinancialAsset);
router.delete('/assets/:id', deleteFinancialAsset);
router.get('/liabilities', listFinancialLiabilities);
router.post('/liabilities', createFinancialLiability);
router.patch('/liabilities/:id', updateFinancialLiability);
router.delete('/liabilities/:id', deleteFinancialLiability);

export default router;
