import { Router } from 'express';
import {
  createExpense,
  deleteExpense,
  getExpense,
  getExpensesSummary,
  listExpenseCategories,
  listExpenses,
  updateExpense,
} from '../controllers/expenses.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/summary', getExpensesSummary);
router.get('/categories', listExpenseCategories);
router.get('/', listExpenses);
router.post('/', createExpense);
router.get('/:id', getExpense);
router.patch('/:id', updateExpense);
router.delete('/:id', deleteExpense);

export default router;
