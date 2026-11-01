import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';
import { getSessionToken, SESSION_COOKIE } from '../middleware/auth.middleware';
import { presentPayment } from './subscriptions.controller';
import {
  detectCardBrand,
  getPlan,
  isCardExpired,
  luhnValid,
  paymentMethods,
  subscriptionPlans,
} from '../services/subscription.service';

const scrypt = promisify(scryptCallback);
const credentialsSchema = z.object({
  email: z.string().trim().email().transform(value => value.toLowerCase()),
  password: z.string().min(8).max(200),
});

const cardSchema = z.object({
  holder_name: z.string().trim().min(2).max(120),
  number: z.string().trim().min(13).max(23),
  exp_month: z.coerce.number().int().min(1).max(12),
  exp_year: z.coerce.number().int().min(25).max(2099),
  cvv: z.string().trim().regex(/^\d{3,4}$/),
}).superRefine((card, ctx) => {
  const digits = card.number.replace(/\D/g, '');
  if (!luhnValid(digits)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Número do cartão inválido.', path: ['number'] });
  }
  const fullYear = card.exp_year < 100 ? 2000 + card.exp_year : card.exp_year;
  if (fullYear < 2025 || fullYear > 2099) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ano de validade inválido.', path: ['exp_year'] });
  }
  if (isCardExpired(card.exp_month, fullYear)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cartão expirado.', path: ['exp_month'] });
  }
});

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(120),
  plan: z.enum(subscriptionPlans),
  payment_method: z.enum(paymentMethods),
  card: cardSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.payment_method === 'card' && !data.card) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Informe os dados do cartão.',
      path: ['card'],
    });
  }
  if (data.payment_method === 'pix' && data.card) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Não envie dados de cartão com pagamento Pix.',
      path: ['card'],
    });
  }
});

const SESSION_DAYS = 30;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [salt, keyHex] = stored.split(':');
  if (!salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setSessionCookie(res: Response, token: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${secure}`);
}

function publicUser(row: { id: number; email: string; name: string }) {
  return { id: row.id, email: row.email, name: row.name };
}

async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO public.user_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + ($3 * INTERVAL '1 day'))`,
    [createHash('sha256').update(token).digest('hex'), userId, SESSION_DAYS]
  );
  return token;
}

export async function register(req: Request, res: Response, next: NextFunction) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados de cadastro inválidos.',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { name, email, password, plan, payment_method, card } = parsed.data;
  const planInfo = getPlan(plan);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO public.app_users (email, name, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, name`,
      [email, name, passwordHash]
    );
    const user = userResult.rows[0];

    const subscriptionResult = await client.query(
      `INSERT INTO public.subscriptions (user_id, plan, status)
       VALUES ($1, $2, 'pending_payment')
       RETURNING id, plan, status, current_period_start, current_period_end, created_at, updated_at`,
      [user.id, plan]
    );
    const subscription = subscriptionResult.rows[0];

    const cardDigits = card ? card.number.replace(/\D/g, '') : null;
    const paymentResult = await client.query(
      `INSERT INTO public.payments
         (user_id, subscription_id, plan, payment_method, status, amount, currency,
          card_brand, card_last4, card_holder_name)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9)
       RETURNING id, subscription_id, plan, payment_method, status,
                 amount::float8 AS amount, currency,
                 card_brand, card_last4, card_holder_name,
                 gateway, gateway_payment_id,
                 pix_copy_paste, pix_qr_code_base64, pix_expires_at,
                 paid_at, failure_reason, created_at, updated_at`,
      [
        user.id,
        subscription.id,
        plan,
        payment_method,
        Number(planInfo.price.toFixed(2)),
        planInfo.currency,
        cardDigits ? detectCardBrand(cardDigits) : null,
        cardDigits ? cardDigits.slice(-4) : null,
        card?.holder_name ?? null,
      ]
    );

    await client.query('COMMIT');

    const token = await createSession(user.id);
    setSessionCookie(res, token);

    res.status(201).json({
      data: {
        user: publicUser(user),
        subscription,
        payment: presentPayment(paymentResult.rows[0]),
        next_step: payment_method === 'pix'
          ? 'await_pix_gateway'
          : 'await_card_gateway',
      },
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    if ((error as { code?: string })?.code === '23505') {
      res.status(409).json({ error: 'Já existe um usuário com este e-mail' });
      return;
    }
    next(error);
  } finally {
    client.release();
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'E-mail e senha válidos são obrigatórios' });
    return;
  }
  try {
    const result = await pool.query(
      'SELECT id, email, name, password_hash FROM public.app_users WHERE email = $1',
      [parsed.data.email]
    );
    const user = result.rows[0];
    if (!user || !(await checkPassword(parsed.data.password, user.password_hash))) {
      res.status(401).json({ error: 'E-mail ou senha inválidos' });
      return;
    }
    const token = await createSession(user.id);
    setSessionCookie(res, token);
    res.status(200).json({ data: publicUser(user) });
  } catch (error) {
    next(error);
  }
}

export function currentUser(req: Request, res: Response) {
  res.status(200).json({ data: req.user });
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionToken = req.sessionToken ?? getSessionToken(req);
    if (sessionToken) {
      await pool.query(
        'UPDATE public.user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1',
        [createHash('sha256').update(sessionToken).digest('hex')]
      );
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
