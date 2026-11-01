import { Router } from 'express';
import { currentUser, login, logout, register } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();
router.post('/register', register);
router.post('/login', login);
router.get('/me', requireAuth, currentUser);
router.post('/logout', logout);

export default router;
