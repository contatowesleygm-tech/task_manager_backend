import { pool } from "../config/database";

export async function ensureDailyRecords(date: string, userId: number): Promise<void> {
  await pool.query(
    `INSERT INTO task_daily_records (task_item_id, record_date, completed)
     SELECT ti.id, $1::date, FALSE
     FROM task_items ti
     JOIN tasks t ON t.id = ti.task_id
     WHERE t.start_date <= $1::date
       AND (t.end_date IS NULL OR t.end_date >= $1::date)
       AND t.is_active = TRUE
       AND t.user_id = $2
       AND NOT EXISTS (
         SELECT 1
         FROM task_daily_records dr
         WHERE dr.task_item_id = ti.id
           AND dr.record_date = $1::date
       )`,
    [date, userId]
  );
}
