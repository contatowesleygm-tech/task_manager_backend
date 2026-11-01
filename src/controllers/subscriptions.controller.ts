import { NextFunction, Request, Response } from 'express';
import { pool } from '../config/database';
import { listPlans } from '../services/subscription.service';

const subscriptionColumns = `id, plan, status, current_period_start, current_period_end, created_at, updated_at`;
const paymentColumns = `id, subscription_id, plan, payment_method, status,
  amount::float8 AS amount, currency,
  card_brand, card_last4, card_holder_name,
  gateway, gateway_payment_id,
  pix_copy_paste, pix_qr_code_base64, pix_expires_at,
  paid_at, failure_reason, created_at, updated_at`;

function presentPayment(row: Record<string, unknown>) {
  const method = row.payment_method as string;
  const base = {
    id: row.id,
    subscription_id: row.subscription_id,
    plan: row.plan,
    payment_method: method,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    gateway: row.gateway,
    gateway_payment_id: row.gateway_payment_id,
    paid_at: row.paid_at,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (method === 'pix') {
    return {
      ...base,
      pix: {
        copy_paste: row.pix_copy_paste ?? null,
        qr_code_base64: row.pix_qr_code_base64 ?? null,
        expires_at: row.pix_expires_at ?? null,
        ready: Boolean(row.pix_copy_paste),
        message: row.pix_copy_paste
          ? null
          : 'Pagamento Pix registrado. Configure o gateway (ex.: Mercado Pago) para gerar QR Code.',
      },
    };
  }

  return {
    ...base,
    card: row.card_last4
      ? {
          brand: row.card_brand,
          last4: row.card_last4,
          holder_name: row.card_holder_name,
        }
      : null,
    message: row.status === 'paid'
      ? null
      : 'Cartão validado e registrado. Configure o gateway para concluir a cobrança.',
  };
}

export function getSubscriptionPlans(_req: Request, res: Response) {
  res.json({
    data: {
      plans: listPlans(),
      payment_methods: [
        { id: 'pix', label: 'Pix' },
        { id: 'card', label: 'Cartão' },
      ],
    },
  });
}

export async function getMySubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const subscription = await pool.query(
      `SELECT ${subscriptionColumns}
       FROM public.subscriptions
       WHERE user_id = $1
       ORDER BY
         CASE status
           WHEN 'active' THEN 0
           WHEN 'past_due' THEN 1
           WHEN 'pending_payment' THEN 2
           ELSE 3
         END,
         created_at DESC
       LIMIT 1`,
      [req.user!.id]
    );

    if (!subscription.rowCount) {
      res.json({ data: { subscription: null, latest_payment: null } });
      return;
    }

    const payment = await pool.query(
      `SELECT ${paymentColumns}
       FROM public.payments
       WHERE subscription_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [subscription.rows[0].id, req.user!.id]
    );

    res.json({
      data: {
        subscription: subscription.rows[0],
        latest_payment: payment.rows[0] ? presentPayment(payment.rows[0]) : null,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getPayment(req: Request, res: Response, next: NextFunction) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'ID do pagamento inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT ${paymentColumns} FROM public.payments WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Pagamento não encontrado.' });
      return;
    }
    res.json({ data: presentPayment(result.rows[0]) });
  } catch (error) {
    next(error);
  }
}

export { presentPayment, paymentColumns, subscriptionColumns };
