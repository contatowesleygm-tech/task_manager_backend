import { Router } from "express";
import { getReport } from "../controllers/reports.controller";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();
router.use(requireAuth);
router.get("/", getReport);
export default router;
