import { Router } from "express";
import {
  getDailyHistory,
  getDailyHistoryByDate,
  getDailyTasks,
  getMonthlyHistory,
  getWeeklyHistory,
  updateChecklistItem,
} from "../controllers/daily.controller";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();
router.use(requireAuth);
router.get("/", getDailyTasks);
router.get("/history/week", getWeeklyHistory);
router.get("/history/month", getMonthlyHistory);
router.get("/history/:date", getDailyHistoryByDate);
router.get("/history", getDailyHistory);
router.patch("/items/:id", updateChecklistItem);
export default router;
