import { Request, Response } from 'express';
import { z } from 'zod';

const positiveNumber = z.number().positive().finite().max(1_000_000);

const fuelCalculatorSchema = z.object({
  vehicle_model: z.string().trim().min(1).max(100),
  vehicle_type: z.enum(['carro', 'moto']),
  fuel_type: z.enum(['gasolina', 'alcool']),
  fuel_prices: z.object({
    gasolina: positiveNumber,
    alcool: positiveNumber,
  }).strict(),
  consumption_km_per_l: z.object({
    gasolina: positiveNumber.optional(),
    alcool: positiveNumber.optional(),
  }).strict().optional(),
  distance_km: positiveNumber.optional(),
}).strict();

type Fuel = 'gasolina' | 'alcool';

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function calculateFuelCosts(req: Request, res: Response): void {
  const parsed = fuelCalculatorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados inválidos para calcular o gasto de combustível.',
      details: parsed.error.flatten(),
    });
    return;
  }

  const {
    vehicle_model,
    vehicle_type,
    fuel_type,
    fuel_prices,
    consumption_km_per_l,
    distance_km,
  } = parsed.data;
  const gasolineEfficiency = consumption_km_per_l?.gasolina;
  const ethanolEfficiency = consumption_km_per_l?.alcool;
  const hasBothEfficiencies = gasolineEfficiency !== undefined && ethanolEfficiency !== undefined;
  const analysisMethod = hasBothEfficiencies ? 'consumo_informado' : 'regra_dos_70_por_cento';
  const ethanolBreakEvenPrice = hasBothEfficiencies
    ? fuel_prices.gasolina * ethanolEfficiency / gasolineEfficiency
    : fuel_prices.gasolina * 0.7;

  let recommendedFuel: Fuel;
  if (hasBothEfficiencies) {
    recommendedFuel = fuel_prices.alcool / ethanolEfficiency
      < fuel_prices.gasolina / gasolineEfficiency
      ? 'alcool'
      : 'gasolina';
  } else {
    recommendedFuel = fuel_prices.alcool <= ethanolBreakEvenPrice ? 'alcool' : 'gasolina';
  }

  const estimateFuelCost = (fuel: Fuel, efficiency: number | undefined) => {
    if (efficiency === undefined) return null;
    const costPerKilometer = fuel_prices[fuel] / efficiency;
    if (distance_km === undefined) {
      return { cost_per_km: round(costPerKilometer, 4) };
    }
    const liters = distance_km / efficiency;
    return {
      liters: round(liters, 3),
      cost: round(liters * fuel_prices[fuel]),
      cost_per_km: round(costPerKilometer, 4),
    };
  };
  const gasolineEstimate = estimateFuelCost('gasolina', gasolineEfficiency);
  const ethanolEstimate = estimateFuelCost('alcool', ethanolEfficiency);
  const savingsForDistance = hasBothEfficiencies && distance_km !== undefined
    ? round(Math.abs(
      fuel_prices.gasolina / gasolineEfficiency - fuel_prices.alcool / ethanolEfficiency
    ) * distance_km)
    : null;

  res.json({
    data: {
      vehicle: { model: vehicle_model, type: vehicle_type },
      analysis_method: analysisMethod,
      selected_fuel: fuel_type,
      fuel_prices: fuel_prices,
      comparison: {
        ethanol_price_as_percentage_of_gasoline: round(
          fuel_prices.alcool / fuel_prices.gasolina * 100
        ),
        ethanol_break_even_price: round(ethanolBreakEvenPrice),
        recommended_fuel: recommendedFuel,
        selected_fuel_is_cheaper: recommendedFuel === fuel_type,
        estimated_savings_for_distance: savingsForDistance,
      },
      estimates: {
        distance_km: distance_km ?? null,
        gasolina: gasolineEstimate,
        alcool: ethanolEstimate,
        selected_fuel_cost: fuel_type === 'gasolina' ? gasolineEstimate : ethanolEstimate,
      },
      notes: [
        hasBothEfficiencies
          ? 'A recomendação usa o consumo informado para cada combustível.'
          : 'Sem o consumo em km/L dos dois combustíveis, a recomendação usa a regra aproximada de 70% (álcool compensa quando custa até 70% da gasolina).',
        'O modelo do veículo não consulta automaticamente consumo nem compatibilidade; informe o consumo medido e confirme no manual se o veículo aceita álcool.',
        distance_km !== undefined && (gasolineEstimate === null || ethanolEstimate === null)
          ? 'Estimativas de gasto e economia exigem distância e consumo em km/L do combustível correspondente.'
          : '',
      ].filter(Boolean),
    },
  });
}
