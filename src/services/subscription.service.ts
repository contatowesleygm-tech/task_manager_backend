export const subscriptionPlans = ['monthly', 'annual'] as const;
export type SubscriptionPlan = (typeof subscriptionPlans)[number];

export const paymentMethods = ['pix', 'card'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const subscriptionStatuses = [
  'pending_payment', 'active', 'past_due', 'cancelled', 'expired',
] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const paymentStatuses = [
  'pending', 'awaiting_payment', 'paid', 'failed', 'cancelled',
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

const planCatalog = {
  monthly: {
    id: 'monthly' as const,
    label: 'Mensal',
    period: '/mês',
    price: Number(process.env.SUBSCRIPTION_PRICE_MONTHLY ?? 29.9),
    currency: 'BRL',
    interval_days: 30,
  },
  annual: {
    id: 'annual' as const,
    label: 'Anual',
    period: '/ano',
    price: Number(process.env.SUBSCRIPTION_PRICE_ANNUAL ?? 299.9),
    currency: 'BRL',
    interval_days: 365,
  },
};

export function getPlan(plan: SubscriptionPlan) {
  return planCatalog[plan];
}

export function listPlans() {
  return subscriptionPlans.map(id => {
    const plan = planCatalog[id];
    return {
      id: plan.id,
      label: plan.label,
      period: plan.period,
      price: Number(plan.price.toFixed(2)),
      currency: plan.currency,
      interval_days: plan.interval_days,
    };
  });
}

export function detectCardBrand(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (/^4/.test(digits)) return 'visa';
  if (/^5[1-5]/.test(digits) || /^2(2[2-9]|[3-6]|7[01]|720)/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^(636368|438935|504175|451416|636297|5067|4576|4011|506699)/.test(digits)) return 'elo';
  if (/^(606282|3841)/.test(digits)) return 'hipercard';
  return 'unknown';
}

export function luhnValid(number: string): boolean {
  const digits = number.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function isCardExpired(month: number, year: number): boolean {
  const now = new Date();
  const fullYear = year < 100 ? 2000 + year : year;
  const expires = new Date(fullYear, month, 0, 23, 59, 59, 999);
  return expires < now;
}

export function periodEndFrom(start: Date, plan: SubscriptionPlan): Date {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + planCatalog[plan].interval_days);
  return end;
}
