import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';

const fuels = ['gasolina', 'alcool'] as const;
const fuelSchema = z.object({
  gasolina: z.number().positive().max(100_000).nullable(),
  alcool: z.number().positive().max(100_000).nullable(),
});
const routeOptionSchema = z.object({
  distance_km: z.number().positive().max(1_000_000),
  duration_seconds: z.number().nonnegative().max(10_000_000),
});
const legSchema = z.object({
  id: z.number().int().positive(),
  origin: z.string().trim().min(1).max(300),
  destination: z.string().trim().min(1).max(300),
  distance_km: z.number().positive().max(1_000_000),
  fuel_type: z.enum(fuels),
  route_description: z.string().trim().max(700).nullable().optional(),
  route_options: z.array(routeOptionSchema).max(5).optional(),
  selected_route_index: z.number().int().min(0).max(4).nullable().optional(),
});
const saveSchema = z.object({
  vehicle_model: z.string().trim().min(1).max(100),
  vehicle_type: z.enum(['carro', 'moto']),
  selected_fuel: z.enum(fuels),
  fuel_prices: fuelSchema,
  consumption_km_per_l: fuelSchema,
  legs: z.array(legSchema).min(1).max(100),
});
const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const dateSchema = z.string().date();

function routeDayFromRow(row: Record<string, unknown>) {
  return {
    route_date: row.route_date,
    vehicle_model: row.vehicle_model,
    vehicle_type: row.vehicle_type,
    selected_fuel: row.selected_fuel,
    fuel_prices: row.fuel_prices,
    consumption_km_per_l: row.consumption_km_per_l,
    legs: row.legs,
    total_distance_km: Number(row.total_distance_km),
    total_fuel_liters: row.total_fuel_liters === null ? null : Number(row.total_fuel_liters),
    total_fuel_cost: row.total_fuel_cost === null ? null : Number(row.total_fuel_cost),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listDailyRouteDays(req: Request, res: Response, next: NextFunction) {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Parâmetros de histórico inválidos.', details: parsed.error.flatten() });
    return;
  }
  const { page, limit } = parsed.data;
  try {
    const [count, result] = await Promise.all([
      pool.query(
        'SELECT COUNT(*)::int AS total FROM public.daily_route_days WHERE user_id = $1',
        [req.user!.id]
      ),
      pool.query(
        `SELECT route_date::text AS route_date, vehicle_model, vehicle_type, selected_fuel,
                fuel_prices, consumption_km_per_l, legs, total_distance_km::float8 AS total_distance_km,
                total_fuel_liters::float8 AS total_fuel_liters, total_fuel_cost::float8 AS total_fuel_cost,
                created_at, updated_at
         FROM public.daily_route_days
         WHERE user_id = $1
         ORDER BY route_date DESC
         LIMIT $2 OFFSET $3`,
        [req.user!.id, limit, (page - 1) * limit]
      ),
    ]);
    const total = Number(count.rows[0].total);
    res.json({
      data: result.rows.map(routeDayFromRow),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function saveDailyRouteDay(req: Request, res: Response, next: NextFunction) {
  const date = dateSchema.safeParse(req.params.date);
  if (!date.success) {
    res.status(400).json({ error: 'Informe uma data válida no formato YYYY-MM-DD.' });
    return;
  }
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados do percurso inválidos.', details: parsed.error.flatten() });
    return;
  }

  const day = parsed.data;
  const totalDistance = day.legs.reduce((sum, leg) => sum + leg.distance_km, 0);
  const hasCompleteConsumption = day.legs.every(leg => day.consumption_km_per_l[leg.fuel_type] !== null);
  const hasCompleteFuelData = hasCompleteConsumption
    && day.legs.every(leg => day.fuel_prices[leg.fuel_type] !== null);
  const totalLiters = hasCompleteConsumption
    ? day.legs.reduce((sum, leg) => sum + leg.distance_km / day.consumption_km_per_l[leg.fuel_type]!, 0)
    : null;
  const totalCost = hasCompleteFuelData
    ? day.legs.reduce((sum, leg) =>
      sum + (leg.distance_km / day.consumption_km_per_l[leg.fuel_type]!) * day.fuel_prices[leg.fuel_type]!,
    0)
    : null;

  try {
    const result = await pool.query(
      `INSERT INTO public.daily_route_days
         (user_id, route_date, vehicle_model, vehicle_type, selected_fuel, fuel_prices,
          consumption_km_per_l, legs, total_distance_km, total_fuel_liters, total_fuel_cost)
       VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
       ON CONFLICT (user_id, route_date) DO UPDATE SET
         vehicle_model = EXCLUDED.vehicle_model,
         vehicle_type = EXCLUDED.vehicle_type,
         selected_fuel = EXCLUDED.selected_fuel,
         fuel_prices = EXCLUDED.fuel_prices,
         consumption_km_per_l = EXCLUDED.consumption_km_per_l,
         legs = EXCLUDED.legs,
         total_distance_km = EXCLUDED.total_distance_km,
         total_fuel_liters = EXCLUDED.total_fuel_liters,
         total_fuel_cost = EXCLUDED.total_fuel_cost,
         updated_at = CURRENT_TIMESTAMP
       RETURNING route_date::text AS route_date, vehicle_model, vehicle_type, selected_fuel,
                 fuel_prices, consumption_km_per_l, legs, total_distance_km::float8 AS total_distance_km,
                 total_fuel_liters::float8 AS total_fuel_liters, total_fuel_cost::float8 AS total_fuel_cost,
                 created_at, updated_at`,
      [
        req.user!.id,
        date.data,
        day.vehicle_model,
        day.vehicle_type,
        day.selected_fuel,
        JSON.stringify(day.fuel_prices),
        JSON.stringify(day.consumption_km_per_l),
        JSON.stringify(day.legs),
        totalDistance,
        totalLiters,
        totalCost,
      ]
    );
    res.status(200).json({ data: routeDayFromRow(result.rows[0]) });
  } catch (error) {
    next(error);
  }
}
