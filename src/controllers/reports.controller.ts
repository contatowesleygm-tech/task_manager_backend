import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool } from "../config/database";

const querySchema = z.object({
  period: z.enum(["week", "month", "year"]).default("week"),
  date: z.string().date().optional()
});

export async function getReport(req: Request, res: Response, next: NextFunction) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Parâmetros inválidos. Use period=week|month|year e date=YYYY-MM-DD opcional."
    });
    return;
  }

  const { period, date } = parsed.data;
  const referenceDate = date ?? new Date().toISOString().slice(0, 10);
  const interval = period === "week" ? "week" : period === "month" ? "month" : "year";

  try {
    const result = await pool.query(
      `WITH bounds AS (
         SELECT DATE_TRUNC($1, $2::date)::date AS start_date,
                (DATE_TRUNC($1, $2::date) + ('1 ' || $1)::interval)::date AS end_date
       ),
       daily AS (
         SELECT dr.record_date,
                COUNT(DISTINCT t.id)::int AS tasks_registered,
                COUNT(dr.id)::int AS total_items,
                COUNT(dr.id) FILTER (WHERE dr.completed)::int AS completed_items
         FROM task_daily_records dr
         JOIN task_items ti ON ti.id = dr.task_item_id
         JOIN tasks t ON t.id = ti.task_id AND t.user_id = $3
         CROSS JOIN bounds b
         WHERE dr.record_date >= b.start_date AND dr.record_date < b.end_date
         GROUP BY dr.record_date
       )
       SELECT b.start_date, b.end_date,
              COALESCE(SUM(d.tasks_registered), 0)::int AS tasks_registered,
              COALESCE(SUM(d.total_items), 0)::int AS total_items,
              COALESCE(SUM(d.completed_items), 0)::int AS completed_items,
              COALESCE(SUM(d.total_items - d.completed_items), 0)::int AS pending_items,
              ROUND(100.0 * SUM(d.completed_items) / NULLIF(SUM(d.total_items), 0), 2)
                AS completion_percentage,
              COALESCE(
                json_agg(json_build_object(
                  'date', d.record_date,
                  'tasks_registered', d.tasks_registered,
                  'total_items', d.total_items,
                  'completed_items', d.completed_items,
                  'pending_items', d.total_items - d.completed_items,
                  'completion_percentage',
                    ROUND(100.0 * d.completed_items / NULLIF(d.total_items, 0), 2)
                ) ORDER BY d.record_date) FILTER (WHERE d.record_date IS NOT NULL),
                '[]'::json
              ) AS days
       FROM bounds b
       LEFT JOIN daily d ON TRUE
       GROUP BY b.start_date, b.end_date`,
      [interval, referenceDate, req.user!.id]
    );
    res.json({ period, reference_date: referenceDate, data: result.rows[0] });
  } catch (error) { next(error); }
}
