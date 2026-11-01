import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import tasksRoutes from "./routes/tasks.routes";
import dailyRoutes from "./routes/daily.routes";
import reportsRoutes from "./routes/reports.routes";
import goalsRoutes from "./routes/goals.routes";
import objectivesRoutes from "./routes/objectives.routes";
import scheduleRoutes from "./routes/schedule.routes";
import { pool } from "./config/database";
import authRoutes from "./routes/auth.routes";
import assistantRoutes from "./routes/assistant.routes";
import studyResourcesRoutes from "./routes/study-resources.routes";
import financesRoutes from "./routes/finances.routes";
import activityRoutes from "./routes/activity.routes";
import englishStudyRoutes from "./routes/english-study.routes";
import expensesRoutes from "./routes/expenses.routes";
import dividendsRoutes from "./routes/dividends.routes";
import subscriptionsRoutes from "./routes/subscriptions.routes";

export const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((value) => value.trim())
    : true,
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      service: "task-manager-api",
      database: "connected"
    });
  } catch {
    res.status(503).json({
      status: "error",
      service: "task-manager-api",
      database: "disconnected"
    });
  }
});

app.use("/api/tasks", tasksRoutes);
app.use("/api/daily", dailyRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/goals", goalsRoutes);
app.use("/api/objectives", objectivesRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/subscriptions", subscriptionsRoutes);
app.use("/api/assistant", assistantRoutes);
app.use("/api/study-resources", studyResourcesRoutes);
app.use("/api/finances", financesRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/english-study", englishStudyRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/dividends", dividendsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Rota não encontrada" });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "Erro interno do servidor" });
});
