import { Router } from "express";
import { activateTask, createTask, deactivateTask, deleteTask, listTasks, updateTask } from "../controllers/tasks.controller";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();
router.use(requireAuth);
router.get("/", listTasks);
router.post("/", createTask);
router.patch("/:id", updateTask);
router.patch("/:id/activate", activateTask);
router.patch("/:id/deactivate", deactivateTask);
router.delete("/:id", deleteTask);
export default router;
