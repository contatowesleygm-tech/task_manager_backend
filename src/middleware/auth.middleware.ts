import { createHash } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { pool } from '../config/database';

const SESSION_COOKIE = 'task_manager_session';

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const item = header.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : undefined;
}

export function getSessionToken(req: Request): string | undefined {
  const authorization = req.header('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim();
  return readCookie(req.header('cookie'), SESSION_COOKIE);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = getSessionToken(req);
  if (!token) {
    res.status(401).json({ error: 'Autenticação necessária' });
    return;
  }
  try {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT u.id, u.email, u.name
       FROM public.user_sessions s
       JOIN public.app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    );
    if (!result.rowCount) {
      res.status(401).json({ error: 'Sessão inválida ou expirada' });
      return;
    }
    req.user = result.rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
}

export { SESSION_COOKIE };
