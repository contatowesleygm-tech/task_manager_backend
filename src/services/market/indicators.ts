export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function periodReturn(values: number[], days: number): number | undefined {
  if (values.length <= days) return undefined;
  const past = values[values.length - 1 - days];
  return past > 0 ? values[values.length - 1] / past - 1 : undefined;
}

export function rsi(values: number[], period = 14): number | undefined {
  if (values.length <= period) return undefined;
  const changes = values.slice(-(period * 3) - 1).map((value, index, all) => (index ? value - all[index - 1] : 0)).slice(1);
  let gain = 0;
  let loss = 0;
  changes.slice(0, period).forEach(change => (change >= 0 ? (gain += change) : (loss -= change)));
  gain /= period;
  loss /= period;
  for (const change of changes.slice(period)) {
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function annualizedVolatility(values: number[], window = 90): number | undefined {
  const slice = values.slice(-(window + 1));
  if (slice.length < 20) return undefined;
  const returns = slice.slice(1).map((value, index) => Math.log(value / slice[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export function drawdownFromHigh(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values[values.length - 1] / Math.max(...values) - 1;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
